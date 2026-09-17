import type { UserRole } from '../supabase';

export function homeFor(role: UserRole): string {
  switch (role) {
    case 'master':                return '/admin';
    case 'branch_manager':
    case 'fulfillment_officer':   return '/dashboard';
    case 'driver':                return '/driver';
    default:                      return '/login';
  }
}

export interface NavItem {
  to: string;
  label: string;
  allow: UserRole[];
}

export const NAV: NavItem[] = [
  { to: '/admin',      label: 'Master',      allow: ['master'] },
  { to: '/dashboard',  label: 'Branch',      allow: ['branch_manager', 'fulfillment_officer', 'master'] },
  { to: '/dispatch',   label: 'Dispatch',    allow: ['master', 'branch_manager', 'fulfillment_officer'] },
  { to: '/zones',      label: 'Zones',       allow: ['master', 'branch_manager', 'fulfillment_officer'] },
  { to: '/orders/new', label: 'New order',   allow: ['master', 'branch_manager', 'fulfillment_officer'] },
  { to: '/driver',     label: 'Driver',      allow: ['driver'] },
];

export function navFor(role: UserRole): NavItem[] {
  return NAV.filter((n) => n.allow.includes(role));
}
