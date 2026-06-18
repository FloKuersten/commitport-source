; Inno Setup script for commitport. Build:  npm run build:installer
; (or:  "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" installer\commitport.iss)
; Produces downloads\commitport-setup.exe — installs the single commitport.exe
; per-user (no admin / UAC needed), with Start-menu + optional desktop shortcut
; and an optional PATH entry for the `commitport` CLI.

#define AppName "commitport"
#define AppVersion "1.0.0"
#define AppPublisher "commitport"
#define AppURL "https://commitport.com"
#define AppExe "commitport.exe"

[Setup]
AppId={{8F3C6B21-7A4E-4C2D-9E1A-2B7D9F4C1E03}}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=..\downloads
OutputBaseFilename=commitport-setup
SetupIconFile=..\assets\commitport.ico
UninstallDisplayIcon={app}\{#AppExe}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "addtopath"; Description: "Add commitport to PATH (run 'commitport' in a terminal)"; GroupDescription: "Command line:"; Flags: unchecked

[Files]
Source: "..\downloads\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\commitport"; Filename: "{app}\{#AppExe}"; WorkingDir: "{userdocs}"
Name: "{group}\Uninstall commitport"; Filename: "{uninstallexe}"
Name: "{autodesktop}\commitport"; Filename: "{app}\{#AppExe}"; WorkingDir: "{userdocs}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; \
  ValueData: "{olddata};{app}"; Tasks: addtopath; Check: NeedsAddPath('{app}')

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch commitport now"; \
  WorkingDir: "{userdocs}"; Flags: nowait postinstall skipifsilent

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + ExpandConstant(Param) + ';', ';' + OrigPath + ';') = 0;
end;
