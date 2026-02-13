---
title: "Integración de Lectores MSR605 con Python - Guía Práctica"
description: "Cómo controlar lectores de tarjetas magnéticas MSR605 desde Python usando comunicación serial y comandos ESC"
date: 2026-02-13
tags: ["Python", "Hardware", "Serial", "MSR605", "Tarjetas Magnéticas"]
---

# Integración de Lectores MSR605 con Python - Guía Práctica

El MSR605 es un lector/grabador de tarjetas magnéticas versátil que se comunica vía puerto serial (RS-232 o USB emulando serial). En esta guía te muestro cómo implementar una clase Python completa para controlar todas sus funciones.

---

## 1. ¿Qué es el MSR605?

El **MSR605** es un dispositivo de lectura/escritura de tarjetas magnéticas que:
- Lee y escribe en **3 tracks** (pistas magnéticas)
- Soporta estándar **ISO7811**
- Se comunica a través de puerto **serial (9600 baud)**
- Incluye LEDs de estado (rojo, amarillo, verde)
- Realiza pruebas de diagnóstico (sensor, RAM, comunicación)

**Aplicaciones comunes:**
- Control de acceso (tarjetas de hotel)
- Lectores POS
- Sistemas de autenticación heredados
- Validación de tarjetas de identificación

---

## 2. Estructura del Código

### Clase `Commands`

Define todos los comandos del MSR605 como métodos que retornan cadenas hexadecimales:

```python
class Commands(object):
    def __init__(self):
        self.ESC = '\x1B'  # Carácter de escape (0x1B)

    def reset(self):
        """Reinicia el MSR605 al estado inicial"""
        return self.ESC + '\x61'

    def read_iso(self):
        """Lee tarjeta y responde con datos decodificados (ISO7811)"""
        return self.ESC + '\x72'

    def write_iso(self):
        """Escribe datos en tarjeta (ISO7811)"""
        return self.ESC + '\x77'
```

Todos los comandos siguen el patrón: `ESC + código_hexadecimal`

### Clase `MSR`

Extiende `serial.Serial` para comunicación con el dispositivo:

```python
class MSR(serial.Serial):
    def __init__(self, dev, test=True, timeout=10):
        super(MSR, self).__init__(dev, 9600, 8, serial.PARITY_NONE, timeout=timeout)
        self.comando = Commands()
        self._send_command(self.comando.reset())
        self._send_command(self.comando.set_low_co())  # Modo de escritura (bajo coercitivo)
        if test:
            self._send_command(self.comando.communication_test())
```

---

## 3. Tabla de Comandos Principales

| Comando | Código | Función | Respuesta |
|:---|:---|:---|:---|
| **reset** | 1B61 | Reinicia el dispositivo | Ninguna |
| **read_iso** | 1B72 | Lee tarjeta completa | [DataBlock]<ESC>[StatusByte] |
| **write_iso** | 1B77 | Escribe en tarjeta | <ESC>[StatusByte] |
| **communication_test** | 1B65 | Verifica conexión | <ESC>y (1B79) |
| **sensor_test** | 1B86 | Test sensor de tarjeta | <ESC>0 (1B30) si OK |
| **ram_test** | 1B87 | Test memoria RAM | <ESC>0 OK o <ESC>A Fallo |
| **get_device_model** | 1B74 | Obtiene modelo | <ESC>[Model]S |
| **get_firmware_version** | 1B76 | Versión firmware | <ESC>[version] |

---

## 4. Leer Datos de la Tarjeta

El método `leer()` captura los 3 tracks de la tarjeta:

```python
def leer(self):
    """
    Lee todos los tracks de la tarjeta y retorna una tupla (track1, track2, track3)
    """
    self._send_command(self.comando.read_iso())
    
    # Cada track termina con su marcador
    track1 = self._read_until(self.tracks.get('1'))[:-2]
    track2 = self._read_until(self.tracks.get('2'))[:-2]
    track3 = self._read_until('\x1C')[:-1]
    
    # Verifica el status byte
    _, status = self.read(2)
    if status == '\x31':
        return "error de lectura"
    
    return track1, track2, track3
```

### Estructura de Tracks

- **Track 1:** Datos completos = nombre + número de tarjeta + fecha expiración
- **Track 2:** Datos mínimos = número de tarjeta + fecha expiración (usado en POS)
- **Track 3:** Datos adicionales (no siempre presente)

**Ejemplo de lectura:**
```
Track1: MEDINA/MILTON^2500123456789?
Track2: 2500123456789=2512101002934891234?
Track3: (vacío o datos adicionales)
```

---

## 5. Escribir en la Tarjeta

El método `escribir_tracks()` graba datos en la tarjeta:

```python
def escribir_tracks(self, t1="", t2="", t3=""):
    """
    Escribe en los tracks especificados
    
    :param t1: Datos Track 1 (SOLO MAYÚSCULAS)
    :param t2: Datos Track 2 (SOLO MAYÚSCULAS)
    :param t3: Datos Track 3 (SOLO MAYÚSCULAS)
    :return: True si éxito, False si fallo
    """
    self._send_command(self.comando.set_hi_co())  # Modo escritura Hi-Co
    
    # Construye el bloque de datos
    data = "\x1B\x77\x1B\x73\x1B\x01" + t1 + "\x1B\x02" + t2 + "\x1B\x03" + t3 + '\x3F\x1C'
    self._send_command(data)
    
    # Lee el byte de estado (8 bytes de respuesta)
    _, _, _, _, _, _, _, self.estado = self.read(8)
    
    return self.estado == '\x30'  # 0x30 = éxito
```

### Consideraciones Importantes

⚠️ **Mayúsculas requeridas:** El MSR605 solo grabará caracteres en mayúsculas. Minúsculas aparecerán como espacios en blanco.

⚠️ **Formato Track 1 estándar:**
```
[NOMBRE/APELLIDO]^[NUMERO TARJETA]?
```

⚠️ **Formato Track 2 estándar:**
```
[NUMERO TARJETA]=[FECHA EXPIRACION][SERVICIO CODE][DISCRETIONARY DATA]?
```

---

## 6. Borrar Datos de Tarjeta

```python
def borrar_tracks(self, tracks):
    """
    Borra pistas específicas
    
    :param tracks: String con tracks a borrar
                   '1', '2', '3', '12', '13', '23', '123'
    """
    self._send_command(self.comando.set_hi_co())
    self._send_command(self.comando.erase_card(), self.tracks.get(tracks))
```

**Mapeo de SelectByte:**
```
00000001 (0x01) → Track 1 solo
00000010 (0x02) → Track 2 solo
00000100 (0x04) → Track 3 solo
00000011 (0x03) → Tracks 1 & 2
00000101 (0x05) → Tracks 1 & 3
00000110 (0x06) → Tracks 2 & 3
00000111 (0x07) → Todos los tracks
```

---

## 7. Control de LEDs

El MSR605 tiene 3 LEDs que se pueden controlar programáticamente:

```python
self._send_command(self.comando.all_leds_off())    # Apaga todos
self._send_command(self.comando.all_leds_on())     # Enciende todos
self._send_command(self.comando.green_led_on())    # Verde (éxito)
self._send_command(self.comando.yellow_led_on())   # Amarillo (espera)
self._send_command(self.comando.red_led_on())      # Rojo (error)
```

**Ejemplo práctico para feedback:**
```python
def leer_con_feedback(self):
    self._send_command(self.comando.yellow_led_on())  # Espera...
    try:
        datos = self.leer()
        self._send_command(self.comando.green_led_on())  # Éxito
        return datos
    except Exception as e:
        self._send_command(self.comando.red_led_on())  # Error
        raise e
```

---

## 8. Métodos Auxiliares

### `_send_command()`
```python
def _send_command(self, command, *args):
    """Envía comando al dispositivo"""
    self.flushInput()
    self.flushOutput()
    self.write(command + ''.join(args))
    self.flush()
```

Limpia buffers antes de enviar para evitar datos residuales.

### `_read_until()`
```python
def _read_until(self, end):
    """Lee datos hasta encontrar el marcador final"""
    data = ''
    while True:
        data += self.read(1)
        if data.endswith(end):
            return data
```

Bloqueante hasta encontrar el terminador especificado.

---

## 9. Ejemplo de Uso Completo

```python
from msr_controller import MSR

# Inicializar
msr = MSR('/dev/ttyUSB0', test=True)

# Leer tarjeta
try:
    track1, track2, track3 = msr.leer()
    print(f"Track 1: {track1}")
    print(f"Track 2: {track2}")
except Exception as e:
    print(f"Error: {e}")

# Escribir en tarjeta
exito = msr.escribir_tracks(
    t1="NEWUSER/JOHN^1234567890123?",
    t2="1234567890123=2512101002934891234?"
)

if exito:
    print("Tarjeta grabada exitosamente")
else:
    print("Error al grabar tarjeta")

# Verificación
msr._send_command(msr.comando.communication_test())
respuesta = msr.read(2)
print(f"Test comunicación: {respuesta}")

msr.close()
```

---

## 10. Troubleshooting

| Problema | Causa Probable | Solución |
|:---|:---|:---|
| Comando no responde | Puerto serial incorrecto | Verificar con `lsusb` o Device Manager |
| Lee datos vacíos | Tarjeta no pasa correctamente | Limpiar cabezal sensor |
| Error en escritura | Tarjeta bloqueada Hi-Co | Usar `set_low_co()` para tarjetas de prueba |
| Minúsculas aparecen como espacios | Formato - MSR605 requiere mayúsculas | Convertir input a `.upper()` |
| RAM test falla | Hardware dañado | Reiniciar con `reset()` |
| Timeout en lectura | Sensor no detecta tarjeta | Revisar conexión física, limpiar sensor |

---

## 11. Configuración de Coercitividad

El MSR605 soporta dos modos de escritura:

**Hi-Coercitivo (HC):** Tarjetas de larga duración (acero)
```python
self._send_command(self.comando.set_hi_co())
```

**Low-Coercitivo (LC):** Tarjetas temporales (hoteles, pruebas)
```python
self._send_command(self.comando.set_low_co())
```

Verificar estado actual:
```python
self._send_command(self.comando.get_hi_co_or_low_costatus())
# Retorna: <ESC>H (Hi-Co) o <ESC>L (Low-Co)
```

---

## Notas Finales

- **Puerto Serial:** Generalmente `/dev/ttyUSB0` (Linux), `COM3` (Windows)
- **Baud Rate:** Siempre 9600
- **Timeout:** Mínimo 10 segundos para operaciones de lectura
- **Limpieza:** Limpiar el cabezal magnético regularmente con alcohol isopropílico
- **Datos sensibles:** No almacenar datos de tarjetas en texto plano

