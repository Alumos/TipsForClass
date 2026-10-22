using System.Speech.Synthesis;
using System.Text;
using System.Text.Json;
using System.Collections.Concurrent;
// Fixed-path child process; structured JSON is never evaluated by a shell.
Console.InputEncoding = Encoding.UTF8;
Console.OutputEncoding = new UTF8Encoding(false);
using var voice = new SpeechSynthesizer();
var jobs = new ConcurrentDictionary<Prompt,string>();
void Emit(object data) { lock (Console.Out) { Console.WriteLine(JsonSerializer.Serialize(data)); Console.Out.Flush(); } }
var chinese = voice.GetInstalledVoices().Where(v => v.Enabled && v.VoiceInfo.Culture.TwoLetterISOLanguageName == "zh").ToList();
if (chinese.Count > 0) voice.SelectVoice(chinese[0].VoiceInfo.Name);
voice.SpeakCompleted += (_, e) => { if (jobs.TryRemove(e.Prompt, out var id) && !e.Cancelled) Emit(new { @event = e.Error == null ? "completed" : "failed", requestId = id }); };
Emit(new { @event = "ready", chineseVoices = chinese.Count });
string? line;
while ((line = Console.ReadLine()) != null) {
 string id = "";
 try {
  if (line.Length > 4096) continue;
  using var doc = JsonDocument.Parse(line);
  string command = doc.RootElement.GetProperty("command").GetString() ?? "";
  if (command == "stop") { voice.SpeakAsyncCancelAll(); continue; }
  id = doc.RootElement.GetProperty("requestId").GetString() ?? "";
  if (command != "speak" || chinese.Count == 0 || id.Length > 80) { Emit(new { @event = "failed", requestId = id }); continue; }
  string text = doc.RootElement.GetProperty("text").GetString() ?? "";
  if (text.Length == 0 || text.Length > 800) { Emit(new { @event = "failed", requestId = id }); continue; }
  voice.SpeakAsyncCancelAll(); var prompt = new Prompt(text); jobs[prompt] = id; voice.SpeakAsync(prompt);
 } catch { Emit(new { @event = "failed", requestId = id }); }
}
