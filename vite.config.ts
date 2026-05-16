import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The legacy App shell is intentionally still monolithic while model
    // stabilization is in flight. Keep the budget explicit so strict
    // verification catches real growth beyond the current ~1.47 MB chunk.
    chunkSizeWarningLimit: 1600,
  },
});
