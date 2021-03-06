import { when } from '@bigtest/convergence';

import logger from '../util/logger';
import ClientServer from './servers/client';
import SocketServer from './servers/sockets';
import ProxyServer from './servers/proxy';

import ReporterManager from './reporters';
import LauncherManager from './browsers';
import PluginManager from './plugins';

import State, { Store, create } from './state';

const { assign } = Object;

export default class Coordinator {
  constructor({
    browsers = [],
    logLevel = 'info',
    reporter: reporterOptions = 'dot',
    plugins: pluginsList = [],
    client: clientOptions = {},
    proxy: proxyOptions = {},
    exit = () => {},
    once = false,
    ...options
  } = {}) {
    logger.level = logLevel;

    // initialize reporter
    let reporter = new ReporterManager(reporterOptions);

    // initialize state
    let store = Store(create(State), (next, state, args) => {
      let results = next(state, args);
      reporter.process(state, results);
      this.handleUpdate(state, results);
      return results;
    });

    // initialize pieces
    let launchers = new LauncherManager(browsers, store);
    let client = new ClientServer(clientOptions);
    let proxy = new ProxyServer(proxyOptions);
    let sockets = new SocketServer(client.server);

    // initialize plugins
    let plugins = new PluginManager(pluginsList, options);
    plugins.setup(client, proxy, sockets, store);

    // client API
    sockets.on('client/connect', (meta, id) => {
      if (id) store.updateLaunched(meta, id);
      sockets.send(meta.id, 'proxy:connected', proxy.url);
    });

    // assign everything
    assign(this, {
      log: logger,
      exit,
      once,
      reporter,
      plugins,
      launchers,
      client,
      proxy,
      sockets,
      store
    });
  }

  handleUpdate(prev, next) {
    // once finished, maybe stop
    if (next.finished && this.once) {
      this.stop(next.status);

    // servers running & browsers connected
    } else if (next.ready) {
      // browsers ready, broadcast run to all connected adapters
      if (!prev.ready) {
        this.sockets.broadcast('adapter', 'run');
      // signal any newly waiting browsers to run
      } else if (prev.browsers !== next.browsers) {
        next.browsers.forEach((browser, b) => {
          let prevb = prev.browsers[b];

          if (!(prevb && prevb.waiting) && browser.waiting) {
            browser.sockets.forEach((socket, s) => {
              if (!(prevb && prevb.sockets[s])) {
                this.sockets.send(socket.id, 'run');
              }
            });
          };
        });
      }
    }
  }

  async start() {
    try {
      // start plugins
      this.log.debug(`Starting plugins...`);
      await this.plugins.start();

      // start proxy
      this.log.debug('Starting proxy server...');
      await this.proxy.start();

      // start client
      this.log.debug('Starting client server...');
      await this.client.start();

      // launch browsers
      this.log.debug('Launching browsers...');
      await this.launchers.launch(this.client.url);

      // give browsers 10 seconds to connect
      await when(() => this.store.ready || (
        throw new Error('Launched browsers did not connect')
      ), 10000);

      // when ready, tests will start running
      this.log.debug('Starting tests...');

      // catch errors and cleanup
    } catch (err) {
      this.log.error(err.message);
      await this.stop(1);
    }
  }

  async stop(status = 0) {
    this.log.debug('Shutting down...');

    // kill all browsers
    this.log.debug('Closing browsers...');
    await this.launchers.kill();

    // stop client and proxy servers
    this.log.debug('Stopping client server...');
    await this.client.stop();

    this.log.debug('Stopping proxy server...');
    await this.proxy.stop();

    // stop plugins
    this.log.debug('Stopping plugins');
    await this.plugins.stop();

    // exit
    return this.exit(status);
  }
}
