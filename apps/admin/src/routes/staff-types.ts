/**
 * Shared types for the staff management route — mirrors the backend UserView contract.
 */
export interface UserView {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'staff';
  disabledAt: string | null;
  lastLoginAt: string | null;
  totpEnabled: boolean;
  createdAt: string;
}

export interface UserListResponse {
  data: UserView[];
  total: number;
  page: number;
  pageSize: number;
}
