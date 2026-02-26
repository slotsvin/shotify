import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

describe('App', () => {
  it('renders the app title Shotify', () => {
    render(<App />)
    expect(screen.getByText('Shotify')).toBeInTheDocument()
  })

  it('shows login prompt when not authenticated', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: /log in with spotify/i })).toBeInTheDocument()
  })

  it('displays Total songs stat', () => {
    render(<App />)
    expect(screen.getByText('Total songs')).toBeInTheDocument()
  })
})
