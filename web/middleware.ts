import { NextResponse, type NextRequest } from 'next/server';

/**
 * sends visitors without a session cookie to /login. This is only a convenience redirect:
 * the API verifies the JWT on every request, and an expired cookie is cleared by the client
 * when the API answers 401 (see lib/api.ts).
 */
export function middleware(req: NextRequest) {
  if (req.cookies.has('session')) return NextResponse.next();

  const login = req.nextUrl.clone();
  login.pathname = '/login';
  login.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/dashboard/:path*', '/payments/:path*'],
};
