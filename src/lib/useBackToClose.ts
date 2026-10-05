import { useEffect, useRef } from 'react';

// While an overlay (editor sheet, dialog) is open it owns one history entry,
// so the browser/Android back button closes the overlay instead of leaving
// the app. Closing it any other way pops that entry again, so history never
// fills up with dead entries.

let stack = 0;

export function useBackToClose(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const marker = `overlay-${++stack}`;
    history.pushState({ ...(history.state ?? {}), overlay: marker }, '');
    let popped = false;
    const onPop = () => {
      // Back pressed: our entry is gone. Only the topmost overlay closes.
      if (history.state?.overlay === marker) return;
      popped = true;
      window.removeEventListener('popstate', onPop);
      closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (!popped && history.state?.overlay === marker) history.back();
    };
  }, [open]);
}
