# Frontend

React/Vite/TypeScript dashboard của GSM Map Sandbox. Xem [README của dự án](../README.md) để thiết lập backend, dữ liệu và điểm dừng A0.

```powershell
npm.cmd install
npm.cmd run dev
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Worker MapLibre được copy local bằng script postinstall/predev/prebuild. shadcn/ui và mapcn là source component trong src/components/ui. Không dùng fixture làm bản đồ thực tế.
