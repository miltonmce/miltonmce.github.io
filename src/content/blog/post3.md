---
title: "Mapear Registros Modbus de un PLC con Python (Guía Práctica)"
description: "Aprende a mapear registros Modbus de un PLC HNC usando Python y PyModbus mediante barridos de registros y pruebas reales."
date: 2026-03-09
tags: ["Modbus", "PLC", "Python", "Automatización Industrial", "IIoT"]
layout: "../../layouts/Layout.astro"
---

# Mapear PLCs con Python

Esta guía está siendo redactada y verificada mediante barridos técnicos reales en hardware **HNC serie HCS**. 

Para la programación de estos equipos utilizaremos el software **HPMaster**. En la parte de desarrollo, emplearemos **Python 3.13** y la librería **PyModbus 3.X**.

## Análisis de Lógica en HPMaster

Antes de programar en Python, es fundamental entender cómo están declaradas las variables en el PLC.


<figure>
  <img src="https://miltonmce.github.io/img/example-plc-hnc.png" alt="Ejemplo PLC HNC" width="500">
  <figcaption>Bloque de ejemplo para mapear variables de interés.</figcaption>
</figure>

### Interpretación de Networks:

* **Network 1:** Observamos un *serial connection switch* y, a la derecha, un contador totalizador (**CV**) con la variable **C48**. Esta variable es de **32 bits**; es vital recordar que en Modbus los registros suelen ser de **16 bits**, por lo que un valor de 32 bits ocupará dos registros consecutivos.
* **Network 2:** Contamos con un switch similar y una salida de bobina (**Out Coil**). Para rastrear estas variables, buscamos valores booleanos: **True/1** (encendido) o **False/0** (apagado).

## Preparación: Monitoreo y Forzado

Para realizar un mapeo exitoso, primero debemos monitorear el PLC desde **HPMaster** para forzar valores conocidos. Esto nos permite confirmar que estamos leyendo la dirección correcta en nuestro script.

<div align="center">
  <figure style="display:inline-block; margin: 10px;">
    <img src="https://miltonmce.github.io/img/force-y0.png" alt="Forzar Y0" width="500">
    <figcaption>Forzamos el encendido de Y0 (Coil)</figcaption>
  </figure>
  <figure style="display:inline-block; margin: 10px;">
    <img src="https://miltonmce.github.io/img/force-cv48.png" alt="Forzar CV48" width="500">
    <figcaption>Forzamos un valor conocido en CV48 (Register)</figcaption>
  </figure>
</div>

---

## Configuración del Entorno Python

En la carpeta de tu proyecto, prepara un entorno virtual para mantener las dependencias limpias:

```bash
# Crear entorno virtual
python -m venv .venv

# Activar entorno
# En Windows:
source .venv/Scripts/activate
# En Linux/macOS:
source .venv/bin/activate

# Instalar librería necesaria
pip install pymodbus
```


## Script de Barrido de Registros Modbus (main.py)
Este script permite realizar un escaneo de registros para identificar dónde se encuentran los datos que forzamos previamente en el PLC.

creamos un nuevo archivo main.py y en el vamos a escribir lo siguiente:


```python

from pymodbus.client import ModbusTcpClient

# --- CONFIGURACIÓN GLOBAL ---
PLC_IP = '192.168.1.111'
PORT = 502
DEVICE_ID = 1  # Unit ID configurado en el PLC

client = ModbusTcpClient(PLC_IP, port=PORT)

def escanear_holding_registers(inicio, fin, valor_esperado, bits32=False):
    """
    Busca registros que coincidan con el valor forzado en el PLC.
    """
    print(f"\n[SCAN] Buscando Holding Registers entre {inicio} y {fin}...")
    if bits32:
        count = 2
    else:
        count = 1
    if client.connect():
        for direccion in range(int(inicio), int(fin) + 1):
            res = client.read_holding_registers(address=direccion, count=count, device_id=DEVICE_ID)
            
            if not res.isError():
                if bits32:
                    # Algunos PLC almacenan primero el registro bajo (low word)
                    # y luego el registro alto (high word).
                    # En ese caso se reconstruye el valor así:
                    
                    valor_leido = (res.registers[1] << 16) | res.registers[0]
                else:
                    valor_leido = res.registers[0]
                if valor_leido == int(valor_esperado):
                    print(f"¡COINCIDENCIA! Dirección {direccion}: Valor = {valor_leido}")
                elif valor_leido != 0:
                    print(f"Dato encontrado en {direccion}: {valor_leido}")
        client.close()
    else:
        print("Error: No se pudo conectar al PLC")

def menu():
    print("--- Herramienta de Mapeo HNC ---")
    print("1. Escanear Holding Registers (V/D)")
    
    op = input("\nSeleccione una opción: ")
    
    if op == "1":
        inicio = input("Registro de inicio: ")
        fin = input("Último registro deseado: ")
        valor_esperado = input("Valor que forzaste en el PLC: ")
        escanear_holding_registers(inicio, fin, valor_esperado)

if __name__ == "__main__":
    menu()

```
## Nota sobre registros de 32 bits

Algunos PLC almacenan variables de 32 bits utilizando dos registros
consecutivos de 16 bits.

Dependiendo de la arquitectura del PLC, el orden puede variar:

- **Big Endian**
- **Little Endian**

En este ejemplo se reconstruye el valor utilizando:

(high << 16) | low

## Arquitectura de prueba

Para las pruebas de esta guía se utilizó la siguiente arquitectura:

PLC HNC HCS - Modbus TCP - Red local - Laptop con Python 3.13 -
Script de escaneo con PyModbus


## Conclusión

El mapeo de registros Modbus es una técnica fundamental cuando se trabaja
con PLCs industriales sin documentación completa.

Mediante el uso de Python y PyModbus es posible automatizar el proceso
de descubrimiento de registros, permitiendo integrar PLCs con sistemas
modernos de monitoreo, telemetría o SCADA personalizados.

## Próximas secciones de la guía

En las siguientes actualizaciones de esta guía se abordarán temas más avanzados de integración entre PLCs y Python:

- Escaneo automático de **Coils**
- Lectura de **Input Registers**
- Escritura de registros Modbus desde Python
- Estrategias para **mapear PLCs sin documentación**

Si trabajas con PLCs industriales y necesitas integrarlos con
software moderno, Python y Modbus ofrecen una forma poderosa
de automatizar la lectura y análisis de datos.

Esta guía continuará expandiéndose con nuevas herramientas
y ejemplos prácticos de integración industrial.