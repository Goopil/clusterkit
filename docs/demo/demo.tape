Output demo-clusterkit.gif

Set Shell "zsh"
Set FontSize 17
Set Width 1180
Set Height 660
Set Theme {"background": "#0d1117", "foreground": "#e6edf3", "cursor": "#58a6ff", "black": "#484f58", "green": "#3fb950", "yellow": "#d29922", "red": "#f85149", "blue": "#58a6ff", "magenta": "#bc8cff", "cyan": "#39c5cf", "white": "#e6edf3"}

Type "node demo-server.mjs &"
Enter
Sleep 4s

Type "curl -s localhost:4321 && curl -s localhost:4321"
Enter
Sleep 1.2s

# Crash one worker — the orchestrator detects it and forks a replacement with backoff
Type "kill -9 $(pgrep -P $! | head -1)"
Enter
Sleep 3.5s

Type "curl -s localhost:4321"
Enter
Sleep 800ms

# Zero-downtime rolling restart of the whole fleet
Type "kill -HUP $!"
Enter
Sleep 6s

Type "curl -s localhost:4321"
Enter
Sleep 1s

Ctrl+C
Sleep 2s
