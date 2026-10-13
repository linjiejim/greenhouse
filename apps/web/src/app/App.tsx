import { useSession } from './session';

/** Placeholder until the shell lands on the kit (M1.1). */
export function App() {
  const { signedIn, me } = useSession();
  return <main>{signedIn ? (me ? `Greenhouse · ${me.name}` : '…') : 'Greenhouse'}</main>;
}
