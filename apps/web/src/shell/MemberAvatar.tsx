/** A person: their picture, else the first letter of their name on the selection tint. */
export function MemberAvatar({ name, url, size = 28 }: { name: string; url?: string | null; size?: number }) {
  const style = { width: size, height: size, minWidth: size };
  if (url) return <img className="app-member-avatar" src={url} alt="" style={style} />;
  return (
    <span className="app-member-avatar" style={{ ...style, fontSize: Math.round(size * 0.42) }} aria-hidden>
      {Array.from(name.trim())[0]?.toUpperCase() ?? '?'}
    </span>
  );
}
