import { startContentBridge } from '@/lib/runtime/transport/bridge-server';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  main() {
    startContentBridge();
  },
});
