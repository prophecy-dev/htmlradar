import { redirect } from 'next/navigation';

// Internal deployment: no marketing site. The dashboard is the home page.
export default function Home() {
  redirect('/docs');
}
