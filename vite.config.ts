import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on every interface, not just IPv6 loopback.
    //
    // Vite's default binds to `localhost`, which on this machine resolves to
    // ::1 only. Chrome resolves `localhost` to 127.0.0.1 and was getting a
    // connection refused error page while curl (preferring ::1) worked fine.
    // Binding to all interfaces fixes that, and is also what makes the dev
    // server reachable from an iPhone on the same Wi-Fi.
    host: true,
  },
})
