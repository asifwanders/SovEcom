import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

describe('App', () => {
  it('renders login page by default when unauthenticated', () => {
    render(<App />);
    expect(screen.getByText('Sign in to SovEcom')).toBeInTheDocument();
  });
});
