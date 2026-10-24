import { useEffect, useState } from 'react';
import { stateForWork, type PlantWork } from './plant-work';
/** Only an observed successful completion plays done; loading history never replays it. */
export function usePlantWorkState(work: PlantWork) {
  const busy = !!(work.working || work.streaming);
  const [previous, setPrevious] = useState(busy);
  const [done, setDone] = useState(false);
  const [hello, setHello] = useState(!!work.greeting);
  if (previous !== busy) {
    setPrevious(busy);
    setDone(!busy && !work.failed && !work.waiting);
  }
  useEffect(() => {
    if (!done && !hello) return;
    const timer = setTimeout(() => {
      setDone(false);
      setHello(false);
    }, 1400);
    return () => clearTimeout(timer);
  }, [done, hello]);
  return stateForWork({ ...work, completed: done, greeting: hello });
}
