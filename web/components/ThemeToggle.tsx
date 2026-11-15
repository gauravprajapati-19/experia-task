'use client';

import { Moon, Sun } from 'lucide-react';
import { Button } from './ui';

export function ThemeToggle() {
  function toggle() {
    const dark = !document.documentElement.classList.contains('dark');
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('theme', dark ? 'dark' : 'light');
    } catch {
      // storage can be blocked (private mode); the toggle still works for this page view
    }
  }

  // both icons are rendered and CSS shows the right one, so server and client markup always match
  return (
    <Button variant="ghost" onClick={toggle} aria-label="Toggle dark mode" title="Toggle dark mode" className="w-9 px-0">
      <Sun aria-hidden className="hidden size-4 dark:block" />
      <Moon aria-hidden className="size-4 dark:hidden" />
    </Button>
  );
}
