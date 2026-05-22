import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { CakeSlice } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import type { Role } from '@/lib/types';

/**
 * Login page — Faza-1 Sprint 0 UI placeholder.
 *
 * NOTE: not yet wired to `POST /api/auth/login`. Submitting issues a
 * local stub session so the protected layout can be navigated during
 * scaffold development. Replace the stub with a real API call in Sprint 1+.
 */
export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Stub session — backend integration pending (Sprint 1+).
    const stubRole: Role = 'pm';
    login('stub-token', {
      id: 'stub-user',
      name: email || 'Sinov foydalanuvchi',
      email: email || 'pm@adia.local',
      role: stubRole,
      location_id: null,
    });
    navigate('/dashboard', { replace: true });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <CakeSlice className="size-9 text-primary" aria-hidden="true" />
          <CardTitle className="text-xl">CAKE ERP</CardTitle>
          <CardDescription>Tizimga kirish</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">Elektron pochta</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="pochta@adia.local"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Parol</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full">
              Kirish
            </Button>
          </form>
          <p className="mt-4 text-center text-xs text-muted-foreground">
            Backend ulanmagan — Sprint 0 interfeys skeleti.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
