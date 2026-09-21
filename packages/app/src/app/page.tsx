import { redirect } from 'next/navigation';

export const runtime = 'edge';

// Internal deployment: no marketing site. The dashboard is the home page.
export default function Home() {
  redirect('/docs');
}
