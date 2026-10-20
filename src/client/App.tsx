import { useEffect, useState } from 'react';
import { GroupPage } from './GroupPage';
import { StartPage } from './StartPage';

// Two pages, so a tiny router: "/" starts a group, "/g/:groupId" shows one.
export function App() {
  const [path, setPath] = useState(location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(location.pathname);
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, []);

  function navigate(to: string) {
    history.pushState(null, '', to);
    setPath(to);
  }

  const groupId = /^\/g\/([\w-]+)$/.exec(path)?.[1];
  return groupId ? (
    <GroupPage key={groupId} groupId={groupId} />
  ) : (
    <StartPage onCreated={(id) => navigate(`/g/${id}`)} />
  );
}
