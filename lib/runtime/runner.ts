import { installEngine } from './engine';

/**
 * MAIN-world engine.
 *
 * The launcher embedded in each registered script calls
 * `__LUMO_RUNNER__.run(payload)`. The engine owns the GM API implementation and
 * talks to the ISOLATED content-script bridge directly; it no longer depends on
 * the USER_SCRIPT host.
 */
installEngine({
  world: 'MAIN',
  sandboxMode: 'raw',
  engineKey: '__LUMO_RUNNER__',
  queueKey: '__LUMO_RUNNER_QUEUE__',
});
