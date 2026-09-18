import { useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 768;
const query = () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

const subscribe = (onChange: () => void) => {
  const media = query();
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};

export const useIsMobile = (): boolean => useSyncExternalStore(subscribe, () => query().matches);
