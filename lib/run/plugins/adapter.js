import BasePlugin from './base';
import { maybeResolveLocal } from '../util/common';

const { assign } = Object;

export function resolveAdapterPath(name) {
  let module = maybeResolveLocal('adapters', name);

  if (!module) throw new Error(`cannot find adapter "${name}"`);

  return module;
}

export default class AdapterPlugin extends BasePlugin {
  static name = 'adapter';

  static defaults = {
    mocha: {
      inject: {
        head: ['mocha/mocha.js']
      }
    }
  };

  constructor(options) {
    let defaults = AdapterPlugin.defaults[options.name];

    if (!options.module) {
      options = assign({}, options, {
        module: resolveAdapterPath(options.name)
      });
    }

    super(assign({}, defaults, options));
  }

  setup(client, proxy, sockets, store) {
    let { inject = {}, ...options } = this.options;

    // stringify options needed by the adapter
    let opts = JSON.stringify(assign({}, options, {
      client: client.url
    }));

    // inject the adapter and supporting elements
    proxy.inject(assign({}, inject, {
      head: (inject.head || []).concat([
        { script: '/adapter.js', serve: this.options.module },
        { script: true, innerContent: `__bigtest__.default.init(${opts})` }
      ])
    }));

    // define the adapter API
    sockets
      .on('adapter/connect', store.connectBrowser)
      .on('adapter/disconnect', store.disconnectBrowser)
      .on('adapter/start', store.startTests)
      .on('adapter/update', store.updateTests)
      .on('adapter/end', store.endTests);
  }
}
