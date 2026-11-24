import React, { useEffect, useState } from 'react';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { RoomPage } from './pages/RoomPage';
import { User } from './types';
import { Loader2 } from 'lucide-react';

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('codesync_token'));
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState(true);
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem('codesync_theme');
    return saved ? saved === 'dark' : true;
  });

  // Extract roomCode from window URL path if present (e.g. /room/7XK92F)
  useEffect(() => {
    const path = window.location.pathname;
    if (path.startsWith('/room/')) {
      const code = path.split('/room/')[1]?.split('/')[0]?.toUpperCase();
      if (code) {
        setRoomCode(code);
      }
    }
  }, []);

  // Validate session on load
  useEffect(() => {
    async function verifyAuth() {
      // Check if there is an id_token in the URL hash (from Google OIDC redirect)
      const hash = window.location.hash;
      if (hash && hash.includes('id_token=')) {
        const params = new URLSearchParams(hash.substring(1));
        const idToken = params.get('id_token');
        if (idToken) {
          // Clear hash from address bar cleanly
          window.history.replaceState({}, document.title, window.location.pathname);
          try {
            const res = await fetch('/api/auth/google', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: idToken }),
            });
            if (res.ok) {
              const data = await res.json();
              localStorage.setItem('codesync_token', data.token);
              setToken(data.token);
              setCurrentUser(data.user);
              setIsAuthChecking(false);
              return;
            }
          } catch (e) {
            console.error('Google hash login failed:', e);
          }
        }
      }

      if (!token) {
        setIsAuthChecking(false);
        return;
      }

      try {
        const res = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (res.ok) {
          const data = await res.json();
          setCurrentUser(data.user);
        } else {
          localStorage.removeItem('codesync_token');
          setToken(null);
        }
      } catch (e) {
        console.warn('Auth verification failed:', e);
      } finally {
        setIsAuthChecking(false);
      }
    }

    verifyAuth();
  }, [token]);

  const handleLoginSuccess = (newToken: string, user: User) => {
    setToken(newToken);
    setCurrentUser(user);
  };

  const handleLogout = () => {
    localStorage.removeItem('codesync_token');
    setToken(null);
    setCurrentUser(null);
    setRoomCode(null);

    // Call Google's disableAutoSelect if GIS is loaded
    const g = (window as any).google;
    if (g && g.accounts && g.accounts.id) {
      try {
        g.accounts.id.disableAutoSelect();
      } catch (err) {
        console.warn('Error disabling auto-select:', err);
      }
    }

    window.history.pushState({}, '', '/');
  };

  const handleJoinRoom = (code: string) => {
    setRoomCode(code);
    window.history.pushState({}, '', `/room/${code}`);
  };

  const handleLeaveRoom = () => {
    setRoomCode(null);
    window.history.pushState({}, '', '/');
  };

  const handleToggleTheme = () => {
    const nextTheme = !isDarkMode;
    setIsDarkMode(nextTheme);
    localStorage.setItem('codesync_theme', nextTheme ? 'dark' : 'light');
  };

  if (isAuthChecking) {
    return (
      <div className="min-h-screen bg-[#14161C] text-[#ECECEF] flex flex-col items-center justify-center space-y-3 font-mono">
        <Loader2 className="w-8 h-8 animate-spin text-[#EF4B4B]" />
        <p className="text-xs text-[#8D91A0]">Initializing CodeSync session...</p>
      </div>
    );
  }

  // 1. Unauthenticated -> Auth Page
  if (!currentUser) {
    return <AuthPage onLoginSuccess={handleLoginSuccess} isDarkMode={isDarkMode} />;
  }

  // 2. Authenticated in a room -> Room Page
  if (roomCode) {
    return (
      <RoomPage
        roomCode={roomCode}
        currentUser={currentUser}
        isDarkMode={isDarkMode}
        onToggleTheme={handleToggleTheme}
        onLogout={handleLogout}
        onLeaveRoom={handleLeaveRoom}
      />
    );
  }

  // 3. Authenticated on Dashboard -> Dashboard Page
  return (
    <DashboardPage
      currentUser={currentUser}
      onJoinRoom={handleJoinRoom}
      isDarkMode={isDarkMode}
      onToggleTheme={handleToggleTheme}
      onLogout={handleLogout}
    />
  );
}
