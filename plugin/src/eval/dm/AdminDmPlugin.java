package eval.dm;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.CommandExecutor;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;

// Minimal Paper plugin:
//   /info           — re-shows the research-deployment disclosure.
//   PlayerJoinEvent — sends the disclosure to every player as they load in.
//   BlockListener   — emits structured block-change lines into latest.log.
//
// The class is named AdminDmPlugin / artifact AdminDm.jar for historical reasons —
// it used to host a /dm DM channel. That channel was removed (the admin now engages
// with public chat directly). The "[AdminDm]" logger prefix is still load-bearing:
// src/world/events.ts routes block-change lines on that prefix, so renaming would
// cascade beyond the plugin.
public final class AdminDmPlugin extends JavaPlugin implements CommandExecutor, Listener {
  private String[] disclosureLines = new String[0];

  @Override
  public void onEnable() {
    // Drop the packaged disclosure.txt into plugins/AdminDm/ on first run; thereafter
    // the file is whatever the operator put there. Loading happens fresh every onEnable
    // so a /reload picks up edits without restarting Paper.
    saveResource("disclosure.txt", false);
    loadDisclosure();

    getCommand("info").setExecutor(this);
    getServer().getPluginManager().registerEvents(this, this);
    // World-change observer: emits "block_<action> ..." lines through this plugin's
    // logger straight into latest.log, which the harness's LogIngestor already tails.
    // See plugin/src/eval/dm/BlockListener.java and src/world/events.ts.
    getServer().getPluginManager().registerEvents(new BlockListener(getLogger()), this);
    getLogger().info("AdminDm enabled — " + this.disclosureLines.length + " disclosure line(s) loaded, world observer active");
  }

  private void loadDisclosure() {
    File f = new File(getDataFolder(), "disclosure.txt");
    try {
      List<String> lines = Files.readAllLines(f.toPath(), StandardCharsets.UTF_8);
      this.disclosureLines = lines.toArray(new String[0]);
    } catch (IOException e) {
      getLogger().warning("Could not read disclosure.txt (" + e.getMessage() + ") — players will not see a disclosure on join. Restore the file in " + f.getAbsolutePath());
      this.disclosureLines = new String[0];
    }
  }

  // Show the disclosure ~1s after join so it lands AFTER the join/login spam clears the
  // player's chat window. A pure on-join sendMessage often gets buried under the server
  // greeting + resource-pack prompts + join broadcasts.
  @EventHandler
  public void onPlayerJoin(PlayerJoinEvent event) {
    if (this.disclosureLines.length == 0) return;
    var player = event.getPlayer();
    getServer().getScheduler().runTaskLater(this, () -> sendDisclosure(player), 20L);
  }

  private void sendDisclosure(CommandSender to) {
    for (String line : this.disclosureLines) to.sendMessage(line);
  }

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    if (command.getName().equalsIgnoreCase("info")) {
      if (this.disclosureLines.length == 0) {
        sender.sendMessage("§7(no disclosure configured)");
      } else {
        sendDisclosure(sender);
      }
      return true;
    }
    return false;
  }
}
