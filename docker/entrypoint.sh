#!/bin/bash
set -e

# Default to 1 detector instance for low-RAM devices (Pi 4)
DETECTOR_INSTANCES=${DETECTOR_INSTANCES:-2}

if [ "$DETECTOR_INSTANCES" -ge 2 ]; then
    AUTOSTART_2="true"
    echo "[ENTRYPOINT] Starting dual detectors (DETECTOR_INSTANCES=$DETECTOR_INSTANCES)"
else
    AUTOSTART_2="false"
    echo "[ENTRYPOINT] Starting single detector (DETECTOR_INSTANCES=$DETECTOR_INSTANCES)"
fi

# Generate supervisord.conf from template (writable location for UID 1000)
CONF="/home/pasteguard/pasteguard.conf"
TEMPLATE="/home/pasteguard/pasteguard.conf.template"
sed "s|__DETECTOR_2_AUTOSTART__|$AUTOSTART_2|g" "$TEMPLATE" > "$CONF"

echo "[ENTRYPOINT] Generated $CONF with detector-2 autostart=$AUTOSTART_2"

# Start supervisord with the generated config
exec /usr/bin/supervisord -c "$CONF"
