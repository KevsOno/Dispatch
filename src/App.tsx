import type React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useProfile } from './lib/hooks/useProfile';
import { homeFor } from './lib/auth/roles';
import { AppShell } from './components/AppShell';
import { NotAuthorised } from './components/NotAuthorised';
import { OrderComposer } from './features/orders/OrderComposer';
import { DriverShift } from './features/driver/DriverShift';
import { BranchDashboard } from './features/dashboard/BranchDashboard';
import { MasterDashboard } from './features/dashboard/MasterDashboard';
import { DispatchDashboard } from './features/dispatch/DispatchDashboard';
import { TrackOrder } from './features/tracking/TrackOrder';
import { Login } from './features/auth/Login';
import type { UserRole } from './lib/supabase';

function Gate({
  children,
  allow,
}: {
  children: React.ReactElement;
  allow: UserRole[];
}) {
  const { profile, loading } = useProfile();
  if (loading) return <div className="p-6">Loading…</div>;
  if (!profile) return <Navigate to="/login" replace />;
  if (!allow.includes(profile.role)) return <NotAuthorised />;
  return children;
}

function HomeRedirect() {
  const { profile, loading } = useProfile();
  if (loading) return <div className="p-6">Loading…</div>;
  if (!profile) return <Navigate to="/login" replace />;
  return <Navigate to={homeFor(profile.role)} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/track/:tracking_code" element={<TrackOrder />} />
        <Route path="/login" element={<Login />} />

        {/* Staff — everything inside AppShell gets the nav bar */}
        <Route element={<AppShell />}>
          <Route
            path="/orders/new"
            element={
              <Gate allow={['master', 'branch_manager', 'fulfillment_officer']}>
                <OrderComposer />
              </Gate>
            }
          />
          <Route
            path="/driver"
            element={
              <Gate allow={['driver']}>
                <DriverShift />
              </Gate>
            }
          />
          <Route
            path="/dashboard"
            element={
              <Gate allow={['branch_manager', 'fulfillment_officer', 'master']}>
                <BranchDashboard />
              </Gate>
            }
          />
          <Route
            path="/dispatch"
            element={
              <Gate allow={['master', 'branch_manager', 'fulfillment_officer']}>
                <DispatchDashboard />
              </Gate>
            }
          />
          <Route
            path="/admin"
            element={
              <Gate allow={['master']}>
                <MasterDashboard />
              </Gate>
            }
          />
        </Route>

        <Route path="/" element={<HomeRedirect />} />
        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </BrowserRouter>
  );
}
