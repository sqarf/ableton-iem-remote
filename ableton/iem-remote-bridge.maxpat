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
    "rect": [80.0, 80.0, 1000.0, 610.0],
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
          "text": "Ableton IEM Remote — editable integration source",
          "fontsize": 18.0,
          "textcolor": [0.1, 0.45, 0.15, 1.0],
          "patching_rect": [30.0, 25.0, 620.0, 28.0]
        }
      },
      {
        "box": {
          "id": "obj-warning",
          "maxclass": "comment",
          "text": "Package this patch manually as a Max MIDI Effect. Rehearsal-test every mapping before connecting performer outputs; this source intentionally never changes Live routing.",
          "linecount": 2,
          "patching_rect": [30.0, 60.0, 830.0, 38.0]
        }
      },
      {
        "box": {
          "id": "obj-controls-label",
          "maxclass": "comment",
          "text": "Node-for-Max process and server controls",
          "patching_rect": [30.0, 120.0, 300.0, 20.0]
        }
      },
      {
        "box": {
          "id": "obj-script-start",
          "maxclass": "message",
          "text": "script start",
          "patching_rect": [30.0, 150.0, 78.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-script-stop",
          "maxclass": "message",
          "text": "script stop",
          "patching_rect": [120.0, 150.0, 75.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-server-start",
          "maxclass": "message",
          "text": "iem.server.start",
          "patching_rect": [210.0, 150.0, 112.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-server-stop",
          "maxclass": "message",
          "text": "iem.server.stop",
          "patching_rect": [335.0, 150.0, 108.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-rescan",
          "maxclass": "message",
          "text": "iem.server.rescan",
          "patching_rect": [455.0, 150.0, 122.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-status",
          "maxclass": "message",
          "text": "iem.server.status",
          "patching_rect": [590.0, 150.0, 122.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-node",
          "maxclass": "newobj",
          "text": "node.script node-for-max-adapter.cjs @autostart 1",
          "patching_rect": [30.0, 205.0, 310.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-route",
          "maxclass": "newobj",
          "text": "route iem.command iem.adapter-status",
          "patching_rect": [30.0, 245.0, 230.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-command-tee",
          "maxclass": "newobj",
          "text": "t l l",
          "patching_rect": [30.0, 285.0, 38.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-prepend",
          "maxclass": "newobj",
          "text": "prepend iem.command",
          "patching_rect": [30.0, 325.0, 138.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-controller",
          "maxclass": "newobj",
          "text": "js live-api-controller.js",
          "patching_rect": [30.0, 370.0, 150.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-event-tee",
          "maxclass": "newobj",
          "text": "t l l",
          "patching_rect": [30.0, 415.0, 38.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-command-print",
          "maxclass": "newobj",
          "text": "print iem-command",
          "patching_rect": [205.0, 325.0, 120.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-event-print",
          "maxclass": "newobj",
          "text": "print iem-event",
          "patching_rect": [205.0, 415.0, 105.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-status-print",
          "maxclass": "newobj",
          "text": "print iem-adapter-status",
          "patching_rect": [285.0, 285.0, 160.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-thisdevice-label",
          "maxclass": "comment",
          "text": "Re-resolve after the Max for Live device reaches its low-priority ready state",
          "patching_rect": [510.0, 260.0, 440.0, 20.0]
        }
      },
      {
        "box": {
          "id": "obj-thisdevice",
          "maxclass": "newobj",
          "text": "live.thisdevice",
          "patching_rect": [510.0, 295.0, 92.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-deferlow",
          "maxclass": "newobj",
          "text": "deferlow",
          "patching_rect": [620.0, 295.0, 56.0, 22.0]
        }
      },
      {
        "box": {
          "id": "obj-boundary-note",
          "maxclass": "comment",
          "text": "Stable IDs and exact configured names cross the Node→Max boundary. The controller resolves current Live paths, owns LiveAPI observers, and returns only normalized confirmed values with a current mapping generation.",
          "linecount": 3,
          "patching_rect": [30.0, 490.0, 870.0, 55.0]
        }
      }
    ],
    "lines": [
      { "patchline": { "source": ["obj-script-start", 0], "destination": ["obj-node", 0] } },
      { "patchline": { "source": ["obj-script-stop", 0], "destination": ["obj-node", 0] } },
      { "patchline": { "source": ["obj-server-start", 0], "destination": ["obj-node", 0] } },
      { "patchline": { "source": ["obj-server-stop", 0], "destination": ["obj-node", 0] } },
      { "patchline": { "source": ["obj-rescan", 0], "destination": ["obj-node", 0] } },
      { "patchline": { "source": ["obj-status", 0], "destination": ["obj-node", 0] } },
      { "patchline": { "source": ["obj-node", 0], "destination": ["obj-route", 0] } },
      { "patchline": { "source": ["obj-route", 0], "destination": ["obj-command-tee", 0] } },
      { "patchline": { "source": ["obj-command-tee", 0], "destination": ["obj-prepend", 0] } },
      { "patchline": { "source": ["obj-command-tee", 1], "destination": ["obj-command-print", 0] } },
      { "patchline": { "source": ["obj-prepend", 0], "destination": ["obj-controller", 0] } },
      { "patchline": { "source": ["obj-controller", 0], "destination": ["obj-event-tee", 0] } },
      { "patchline": { "source": ["obj-event-tee", 0], "destination": ["obj-node", 0] } },
      { "patchline": { "source": ["obj-event-tee", 1], "destination": ["obj-event-print", 0] } },
      { "patchline": { "source": ["obj-route", 1], "destination": ["obj-status-print", 0] } },
      { "patchline": { "source": ["obj-thisdevice", 0], "destination": ["obj-deferlow", 0] } },
      { "patchline": { "source": ["obj-deferlow", 0], "destination": ["obj-rescan", 0] } }
    ]
  }
}
