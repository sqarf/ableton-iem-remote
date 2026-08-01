{
  "patcher": {
    "fileversion": 1,
    "appversion": {
      "major": 8,
      "minor": 6,
      "revision": 0,
      "architecture": "x64",
      "modernui": 1
    },
    "classnamespace": "box",
    "rect": [80.0, 80.0, 980.0, 650.0],
    "bglocked": 0,
    "openinpresentation": 0,
    "default_fontsize": 12.0,
    "default_fontface": 0,
    "default_fontname": "Arial",
    "gridonopen": 1,
    "gridsize": [15.0, 15.0],
    "boxes": [
      {
        "box": {
          "id": "obj-title",
          "maxclass": "comment",
          "text": "Ableton IEM Remote — INTEGRATION SCAFFOLD ONLY (no send control)",
          "fontsize": 18.0,
          "textcolor": [0.8, 0.0, 0.0, 1.0],
          "patching_rect": [30.0, 25.0, 670.0, 28.0]
        }
      },
      {
        "box": {
          "id": "obj-warning",
          "maxclass": "comment",
          "text": "Mock mode is implemented in the repository. Complete the resolver, observers, MaxBridge, and manual safety checklist before creating a show device.",
          "linecount": 2,
          "patching_rect": [30.0, 60.0, 700.0, 38.0]
        }
      },
      {
        "box": {
          "id": "obj-node-label",
          "maxclass": "comment",
          "text": "Node-for-Max transport diagnostics",
          "patching_rect": [30.0, 120.0, 250.0, 20.0]
        }
      },
      {
        "box": {
          "id": "obj-start",
          "maxclass": "message",
          "text": "script start",
          "patching_rect": [30.0, 150.0, 78.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-stop",
          "maxclass": "message",
          "text": "script stop",
          "patching_rect": [120.0, 150.0, 75.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-ping",
          "maxclass": "message",
          "text": "iem.transport.ping",
          "patching_rect": [210.0, 150.0, 122.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-status",
          "maxclass": "message",
          "text": "iem.transport.status",
          "patching_rect": [345.0, 150.0, 135.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-node",
          "maxclass": "newobj",
          "text": "node.script node-for-max-adapter.cjs @autostart 1",
          "patching_rect": [30.0, 195.0, 310.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-route",
          "maxclass": "newobj",
          "text": "route iem.command iem.adapter-status",
          "patching_rect": [30.0, 235.0, 230.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-command-print",
          "maxclass": "newobj",
          "text": "print iem-command-scaffold",
          "patching_rect": [30.0, 275.0, 175.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-status-print",
          "maxclass": "newobj",
          "text": "print iem-adapter-status",
          "patching_rect": [220.0, 275.0, 160.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-live-label",
          "maxclass": "comment",
          "text": "Live API diagnostic objects — manual inspection only",
          "patching_rect": [30.0, 345.0, 330.0, 20.0]
        }
      },
      {
        "box": {
          "id": "obj-thisdevice",
          "maxclass": "newobj",
          "text": "live.thisdevice",
          "patching_rect": [30.0, 380.0, 92.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-deferlow",
          "maxclass": "newobj",
          "text": "deferlow",
          "patching_rect": [140.0, 380.0, 56.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-live-path-message",
          "maxclass": "message",
          "text": "path live_set",
          "patching_rect": [215.0, 380.0, 82.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-live-path",
          "maxclass": "newobj",
          "text": "live.path",
          "patching_rect": [315.0, 380.0, 62.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-live-object",
          "maxclass": "newobj",
          "text": "live.object",
          "patching_rect": [400.0, 380.0, 72.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-tracks-count",
          "maxclass": "message",
          "text": "getcount tracks",
          "patching_rect": [315.0, 425.0, 98.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-returns-count",
          "maxclass": "message",
          "text": "getcount return_tracks",
          "patching_rect": [425.0, 425.0, 138.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-live-print",
          "maxclass": "newobj",
          "text": "print iem-live-api-diagnostic",
          "patching_rect": [400.0, 470.0, 195.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-observer",
          "maxclass": "newobj",
          "text": "live.observer value",
          "patching_rect": [650.0, 380.0, 118.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-observer-warning",
          "maxclass": "comment",
          "text": "Placeholder only: connect a freshly resolved send parameter ID here in the completed controller. Never connect a stored track/send index.",
          "linecount": 3,
          "patching_rect": [650.0, 420.0, 280.0, 55.0]
        }
      },
      {
        "box": {
          "id": "obj-protocol-note",
          "maxclass": "comment",
          "text": "The completed controller must route iem.command JSON to a Live API resolver and return iem.event JSON to node.script. See docs/max-for-live-integration.md.",
          "linecount": 2,
          "patching_rect": [30.0, 545.0, 690.0, 38.0]
        }
      }
    ],
    "lines": [
      { "patchline": { "source": ["obj-start", 0], "destination": ["obj-node", 0] } },
      { "patchline": { "source": ["obj-stop", 0], "destination": ["obj-node", 0] } },
      { "patchline": { "source": ["obj-ping", 0], "destination": ["obj-node", 0] } },
      { "patchline": { "source": ["obj-status", 0], "destination": ["obj-node", 0] } },
      { "patchline": { "source": ["obj-node", 0], "destination": ["obj-route", 0] } },
      { "patchline": { "source": ["obj-route", 0], "destination": ["obj-command-print", 0] } },
      { "patchline": { "source": ["obj-route", 1], "destination": ["obj-status-print", 0] } },
      { "patchline": { "source": ["obj-thisdevice", 0], "destination": ["obj-deferlow", 0] } },
      { "patchline": { "source": ["obj-deferlow", 0], "destination": ["obj-live-path-message", 0] } },
      { "patchline": { "source": ["obj-live-path-message", 0], "destination": ["obj-live-path", 0] } },
      { "patchline": { "source": ["obj-live-path", 0], "destination": ["obj-live-object", 1] } },
      { "patchline": { "source": ["obj-tracks-count", 0], "destination": ["obj-live-object", 0] } },
      { "patchline": { "source": ["obj-returns-count", 0], "destination": ["obj-live-object", 0] } },
      { "patchline": { "source": ["obj-live-object", 0], "destination": ["obj-live-print", 0] } }
    ]
  }
}
