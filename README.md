# MeshCore RX Monitor

Webová aplikace pro monitorování RX logů z MeshCore mesh sítě přes Bluetooth.

## ✨ Funkce

- **Bluetooth připojení**: Připojí se k MeshCore companion přes Web Bluetooth API
- **Dekódování paketů**: Používá knihovnu `@michaelhart/meshcore-decoder` pro dekódování MeshCore paketů
- **Vizualizace**: Každý zachycený hash zprávy je zobrazen jako boxík s historií repeaterů
- **Automatické čištění**: Staré boxíky (starší než 5 minut) automaticky mizí
- **Real-time statistiky**: Sledování počtu aktivních hashů, celkových RX a počtu repeaterů

## 🚀 Jak používat

1. Otevřete `index.html` ve webovém prohlížeči (Chrome, Edge nebo Opera)
   - **Důležité**: Web Bluetooth API vyžaduje HTTPS nebo localhost
   
2. Klikněte na tlačítko "Připojit Bluetooth"

3. Vyberte své MeshCore zařízení ze seznamu

4. Aplikace automaticky začne sledovat RX logy a zobrazovat boxíky pro každý hash

## 📦 Struktura aplikace

- `index.html` - Hlavní HTML stránka
- `style.css` - Styly aplikace
- `app.js` - JavaScript logika s MeshCore dekodérem

## 🔧 Technické detaily

### Bluetooth komunikace

Aplikace používá Nordic UART Service (NUS) pro komunikaci:
- Service UUID: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- TX Characteristic: `6e400003-b5a3-f393-e0a9-e50e24dcca9e` (zařízení → aplikace)

### Dekódování paketů

Aplikace používá knihovnu `@michaelhart/meshcore-decoder` z npm:
- Automaticky dekóduje binární MeshCore pakety
- Extrahuje hash zprávy (packet ID)
- Identifikuje repeatery z routing informací
- Fallback na text parsing, pokud binární dekódování selže

### Zobrazení dat

Pro každý hash zprávy:
- Zobrazí zkrácený hash
- Čas prvního zachycení
- Seznam repeaterů s počítadly
- Progress bar ukazující zbývající čas životnosti

### Konfigurace

Čas životnosti boxíků lze změnit v `app.js`:

```javascript
this.HASH_LIFETIME = 300000; // 5 minut v milisekundách
```

## 📱 Podporované prohlížeče

Web Bluetooth API je podporováno v:
- Google Chrome (desktop & Android)
- Microsoft Edge
- Opera

Safari a Firefox bohužel Web Bluetooth nepodporují.

## 🔐 Bezpečnost

- Aplikace vyžaduje HTTPS nebo localhost
- Bluetooth připojení vyžaduje uživatelský souhlas
- Žádná data nejsou odesílána na server

## 📖 Reference

- [MeshCore Decoder](https://github.com/michaelhart/meshcore-decoder) - TypeScript knihovna pro dekódování paketů
- [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) - MDN dokumentace
- [Nordic UART Service](https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/libraries/bluetooth_services/services/nus.html) - NUS specifikace
