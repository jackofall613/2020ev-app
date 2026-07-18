import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '2020EV Admin',
  description: 'Shared EV Charger Management',
};

// Applies the saved theme before first paint (default: light). Runs inline so
// there is no flash; suppressHydrationWarning covers the class the script adds.
const themeScript = `try{if(localStorage.getItem('theme')==='dark')document.documentElement.classList.add('dark')}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body style={{ minHeight: '100vh' }}>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {children}
      </body>
    </html>
  );
}
