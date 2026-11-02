[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class BrowserWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT {public int Left,Top,Right,Bottom;}
  [StructLayout(LayoutKind.Sequential)] public struct MOUSE {public int dx,dy;public uint mouseData,dwFlags,time;public UIntPtr extra;}
  [StructLayout(LayoutKind.Sequential)] public struct KEY {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
  [StructLayout(LayoutKind.Explicit)] public struct UNION {[FieldOffset(0)]public MOUSE mouse;[FieldOffset(0)]public KEY key;}
  [StructLayout(LayoutKind.Sequential)] public struct INPUT {public uint type;public UNION data;}
  public delegate bool EnumProc(IntPtr window,IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern uint SendInput(uint count,INPUT[] input,int size);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static List<IntPtr> Windows(int pid){var list=new List<IntPtr>();EnumWindows(delegate(IntPtr h,IntPtr p){uint owner;GetWindowThreadProcessId(h,out owner);RECT r;GetWindowRect(h,out r);if(owner==pid&&IsWindowVisible(h)&&r.Right-r.Left>50&&r.Bottom-r.Top>50)list.Add(h);return true;},IntPtr.Zero);return list;}
  static IntPtr Window(int pid){SetProcessDPIAware();var all=Windows(pid);if(all.Count==0)throw new Exception("WINDOW_NOT_READY");IntPtr front=GetForegroundWindow();if(all.Contains(front))return front;return all[0];}
  static IntPtr Focus(int pid){var h=Window(pid);SetForegroundWindow(h);System.Threading.Thread.Sleep(50);uint owner;GetWindowThreadProcessId(GetForegroundWindow(),out owner);if(owner!=pid)throw new Exception("FOCUS_DENIED");return GetForegroundWindow();}
  static void Send(INPUT[] input){if(SendInput((uint)input.Length,input,Marshal.SizeOf(typeof(INPUT)))!=input.Length)throw new Exception("INPUT_DENIED");}
  static INPUT Key(ushort vk,ushort scan,uint flags){return new INPUT{type=1,data=new UNION{key=new KEY{vk=vk,scan=scan,flags=flags}}};}
  static INPUT Mouse(uint flags,uint data){return new INPUT{type=0,data=new UNION{mouse=new MOUSE{dwFlags=flags,mouseData=data}}};}
  public static string Capture(int pid){var h=Window(pid);RECT r;GetWindowRect(h,out r);int w=r.Right-r.Left,height=r.Bottom-r.Top;if(w<1||height<1||w>4096||height>2304)throw new Exception("FRAME_SIZE");using(var image=new Bitmap(w,height)){using(var g=Graphics.FromImage(image)){IntPtr dc=g.GetHdc();bool ok;try{ok=PrintWindow(h,dc,2);}finally{g.ReleaseHdc(dc);}if(!ok)throw new Exception("CAPTURE_DENIED");}using(var output=new MemoryStream()){image.Save(output,ImageFormat.Jpeg);return Convert.ToBase64String(output.ToArray());}}}
  public static void Click(int pid,int x,int y,string button,bool twice){var h=Focus(pid);RECT r;GetWindowRect(h,out r);if(x<0||y<0||x>=r.Right-r.Left||y>=r.Bottom-r.Top)throw new Exception("INPUT_DENIED");SetCursorPos(r.Left+x,r.Top+y);uint down=button=="right"?8u:button=="middle"?32u:2u;uint up=button=="right"?16u:button=="middle"?64u:4u;Send(new[]{Mouse(down,0),Mouse(up,0)});if(twice){System.Threading.Thread.Sleep(80);Send(new[]{Mouse(down,0),Mouse(up,0)});}}
  public static void Text(int pid,string value){Focus(pid);var input=new List<INPUT>();foreach(char c in value){input.Add(Key(0,c,4));input.Add(Key(0,c,6));}Send(input.ToArray());}
  public static void Press(int pid,string value){Focus(pid);var map=new Dictionary<string,ushort>{{"Control",17},{"Meta",91},{"Alt",18},{"Shift",16},{"Enter",13},{"Tab",9},{"Escape",27},{"Backspace",8},{"Delete",46},{"ArrowLeft",37},{"ArrowRight",39},{"ArrowUp",38},{"ArrowDown",40},{"Home",36},{"End",35},{"PageUp",33},{"PageDown",34},{"Space",32},{"F5",116}};var codes=new List<ushort>();foreach(string part in value.Split('+')){ushort key;if(!map.TryGetValue(part,out key)){if(part.Length!=1)throw new Exception("INPUT_DENIED");key=(ushort)Char.ToUpperInvariant(part[0]);}codes.Add(key);}var list=new List<INPUT>();foreach(ushort key in codes)list.Add(Key(key,0,0));codes.Reverse();foreach(ushort key in codes)list.Add(Key(key,0,2));Send(list.ToArray());}
  public static void Scroll(int pid,int x,int y){Focus(pid);if(y!=0)Send(new[]{Mouse(0x800,unchecked((uint)(-Math.Sign(y)*120)))});if(x!=0)Send(new[]{Mouse(0x1000,unchecked((uint)(Math.Sign(x)*120)))});}
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,System.Text.StringBuilder name,int size);
  public static void Upload(int pid,string file){var h=Focus(pid);var name=new System.Text.StringBuilder(256);GetClassName(h,name,256);if(name.ToString()!="#32770")throw new Exception("FILE_DIALOG_REQUIRED");Press(pid,"Alt+n");Text(pid,file);Press(pid,"Enter");}
  public static void Close(int pid){foreach(var h in Windows(pid))PostMessage(h,0x10,IntPtr.Zero,IntPtr.Zero);}
}
'@
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $r = $line | ConvertFrom-Json
    $browserPid = [int]$r.pid
    switch ($r.type) {
      'capture' { $result = @{ image = [BrowserWindow]::Capture($browserPid) } }
      'click' { [BrowserWindow]::Click($browserPid,[int]$r.x,[int]$r.y,[string]$r.button,[bool]$r.double); $result = @{} }
      'text' { [BrowserWindow]::Text($browserPid,[string]$r.text); $result = @{} }
      'key' { [BrowserWindow]::Press($browserPid,[string]$r.key); $result = @{} }
      'scroll' { [BrowserWindow]::Scroll($browserPid,[int]$r.x,[int]$r.y); $result = @{} }
      'upload' { [BrowserWindow]::Upload($browserPid,[string]$r.file); $result = @{} }
      'close' { [BrowserWindow]::Close($browserPid); $result = @{} }
      default { throw 'INPUT_DENIED' }
    }
    @{ok=$true;result=$result} | ConvertTo-Json -Compress -Depth 4
  } catch { $code = if ($_.Exception.ToString().Contains('FILE_DIALOG_REQUIRED')) {'FILE_DIALOG_REQUIRED'} else {'DESKTOP_PERMISSION_REQUIRED'}; @{ok=$false;code=$code} | ConvertTo-Json -Compress }
}
