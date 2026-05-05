# VRM Dashboard 

- `npm install`
- `npm run dev`
-  http://localhost:3000

## Flujo
1. **Escanear**: completa BVMS, VRM, IP y credenciales y hace *Escanear*. Se guarda `Bosch Security Systems - VRM.mhtml` y los HTML de `showCameras`, `showDevices`, `showTargets` en `data/<BVMS>/<VRM o IP>/`.
2. **Adjuntar** o parsear desde carpeta: podés subir archivos descargados o luego usar un POST a `/api/parse-folder`.
3. **Overview**: suma KPIs globales y por VRM.
4. **Cámaras**: mergea Cameras+Devices y exporta CSV.
5. **VRMs**: gráficos de Targets/LUNs/Blocks.

> Sin RCP/CVS. Sólo HTTP + Puppeteer para MHTML del index.