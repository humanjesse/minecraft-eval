package eval.dm;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.OpenOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;

import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.CommandExecutor;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

// Minimal Paper plugin: a non-broadcasting /dm <message> that appends one JSON line per
// message to an inbound spool. The harness tails that spool (see src/dms/ingest.ts).
//
// Deliberately dumb: the plugin only captures and persists the raw message. All meaning,
// delivery, recall, and reply live in the harness. The spool decouples lifecycles — if
// the harness is down, DMs buffer here and are reconciled on its next boot.
public final class AdminDmPlugin extends JavaPlugin implements CommandExecutor {
  private Path spool;

  @Override
  public void onEnable() {
    saveDefaultConfig();
    // spool-path is resolved relative to the server's working directory. The default
    // (../data/dm-inbound.jsonl) lands in the repo-root data/ dir for local dev; it MUST
    // match the harness's DM_INBOUND_PATH.
    String configured = getConfig().getString("spool-path", "../data/dm-inbound.jsonl");
    this.spool = Paths.get(configured).toAbsolutePath().normalize();
    try {
      Files.createDirectories(this.spool.getParent());
    } catch (IOException e) {
      getLogger().severe("Could not create DM spool dir " + this.spool.getParent() + ": " + e.getMessage());
    }
    getCommand("dm").setExecutor(this);
    getLogger().info("AdminDm enabled — /dm spools to " + this.spool);
  }

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    if (!(sender instanceof Player player)) {
      sender.sendMessage("Only players can DM the admin.");
      return true;
    }
    if (args.length == 0) {
      player.sendMessage("Usage: /dm <message>");
      return true;
    }
    String message = String.join(" ", args);
    String line = "{"
        + "\"ts\":" + System.currentTimeMillis() + ","
        + "\"player\":\"" + esc(player.getName()) + "\","
        + "\"uuid\":\"" + esc(player.getUniqueId().toString()) + "\","
        + "\"message\":\"" + esc(message) + "\""
        + "}\n";
    try {
      synchronized (this) {
        Files.write(this.spool, line.getBytes(StandardCharsets.UTF_8),
            new OpenOption[] { StandardOpenOption.CREATE, StandardOpenOption.APPEND });
      }
      player.sendMessage("§7(sent to admin)");
    } catch (IOException e) {
      getLogger().severe("Failed to write DM to spool: " + e.getMessage());
      player.sendMessage("§c(couldn't reach the admin right now — try again)");
    }
    return true;
  }

  // Minimal JSON string escaping — quotes, backslash, and control chars.
  private static String esc(String s) {
    StringBuilder b = new StringBuilder(s.length() + 8);
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"' -> b.append("\\\"");
        case '\\' -> b.append("\\\\");
        case '\n' -> b.append("\\n");
        case '\r' -> b.append("\\r");
        case '\t' -> b.append("\\t");
        default -> {
          if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
          else b.append(c);
        }
      }
    }
    return b.toString();
  }
}
