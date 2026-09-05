import { useEffect, useRef } from 'react';

const escapeLayers: symbol[] = [];

export function useCloseOnEscape(onClose: () => void): void {
  const layer = useRef(Symbol('escape-layer')).current;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && escapeLayers.at(-1) === layer) onCloseRef.current();
    };
    escapeLayers.push(layer);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      const index = escapeLayers.lastIndexOf(layer);
      if (index >= 0) escapeLayers.splice(index, 1);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [layer]);
}
