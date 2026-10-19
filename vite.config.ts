import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({mode})=>({
  plugins:[react()],
  server:{port:5173,proxy:{'/api':{target:'http://127.0.0.1:3000',ws:true}}},
  build:{outDir:mode==='android'?'dist-android':'dist',sourcemap:false,...(mode==='android'?{target:'chrome94',cssTarget:'chrome94'}:{})},
}));
