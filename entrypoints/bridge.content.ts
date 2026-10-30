import { startContentBridge } from '@/lib/runtime/content-bridge';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  main() {
    startContentBridge();
  },
});
