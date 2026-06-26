import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from './auth';

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.setState({
      accessToken: null,
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
  });

  it('starts unauthenticated', () => {
    const state = useAuthStore.getState();
    expect(state.accessToken).toBeNull();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('setAccessToken stores token and sets authenticated', () => {
    useAuthStore.getState().setAccessToken('test-token');
    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('test-token');
    expect(state.isAuthenticated).toBe(true);
  });

  it('setUser stores user', () => {
    const user = { id: 'u1', email: 'a@b.com', name: 'Admin', role: 'admin', totpEnabled: false };
    useAuthStore.getState().setUser(user);
    expect(useAuthStore.getState().user).toEqual(user);
  });

  it('logout clears everything', () => {
    useAuthStore.getState().setAccessToken('token');
    useAuthStore
      .getState()
      .setUser({ id: 'u1', email: 'a@b.com', name: 'Admin', role: 'admin', totpEnabled: false });
    useAuthStore.getState().logout();
    const state = useAuthStore.getState();
    expect(state.accessToken).toBeNull();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('setIsLoading toggles loading state', () => {
    useAuthStore.getState().setIsLoading(true);
    expect(useAuthStore.getState().isLoading).toBe(true);
    useAuthStore.getState().setIsLoading(false);
    expect(useAuthStore.getState().isLoading).toBe(false);
  });
});
