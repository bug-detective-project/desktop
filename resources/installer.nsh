; Uninstalling removes everything the app created in Docker (resources/remove-docker-data.ps1).
; An update also runs the old uninstaller, but with isUpdated set: the player's code stays then.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Removing the Bug Detective data from Docker..."
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\remove-docker-data.ps1"'
    Pop $0
  ${endIf}
!macroend
