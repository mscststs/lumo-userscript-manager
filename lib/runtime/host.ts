import { installEngine } from './engine';

/**
 * USER_SCRIPT-world engine.
 *
 * Used for sandboxed scripts (`@inject-into content`, forced sandbox). The GM
 * object never reaches the page realm, but the transport is identical to the
 * MAIN engine: a window MessageChannel to the ISOLATED content-script bridge.
 */
installEngine({
  world: 'USER_SCRIPT',
  sandboxMode: 'content',
  engineKey: '__LUMO_HOST__',
  queueKey: '__LUMO_HOST_QUEUE__',
});
