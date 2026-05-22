import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from '@/hooks/AuthProvider';
import { AppRouter } from '@/routes/AppRouter';
import { DevAgentation } from '@/components/DevAgentation';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRouter />
      </BrowserRouter>
      <DevAgentation />
    </AuthProvider>
  );
}
