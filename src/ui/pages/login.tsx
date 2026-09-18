import logo from '../../../public/logo.svg';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

const GoogleMark = () => (
  <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
    <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.7-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z" />
    <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.7-4.9H1.3v3.1C3.3 21.4 7.3 24 12 24z" />
    <path fill="#FBBC05" d="M5.3 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.6.4-2.4V6.5H1.3C.5 8.2 0 10 0 12s.5 3.8 1.3 5.5l4-3.1z" />
    <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0 7.3 0 3.3 2.6 1.3 6.5l4 3.1c1-2.8 3.6-4.8 6.7-4.8z" />
  </svg>
);

export const LoginPage = () => {
  const error = new URLSearchParams(window.location.search).get('error');
  const next = window.location.pathname === '/login' ? '/' : window.location.pathname + window.location.search;
  return (
    <div className="flex h-svh items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <img src={logo} alt="" className="mb-2 size-12" />
          <CardTitle>opendeepl</CardTitle>
          <CardDescription>Sign in to reach the projects you were invited to.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Button className="w-full" onClick={() => window.location.assign(`/api/auth/google?next=${encodeURIComponent(next)}`)}>
            <GoogleMark /> Continue with Google
          </Button>
          {error ? <p className="text-center text-sm text-destructive">Sign-in failed: {error}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
};
