package eval.dm;

import java.util.logging.Logger;

import org.bukkit.Location;
import org.bukkit.block.Block;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Hanging;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.block.BlockIgniteEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.block.SignChangeEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.hanging.HangingBreakByEntityEvent;
import org.bukkit.event.hanging.HangingPlaceEvent;
import org.bukkit.event.player.PlayerBucketEmptyEvent;
import org.bukkit.event.player.PlayerBucketFillEvent;

// Emits one log line per Bukkit block-changing event with a player actor. Lines flow
// through Paper's logger -> latest.log -> the harness's LogIngestor -> the world
// reducer (kind: "block_change", routed by the "[AdminDm] block_" prefix in
// src/world/events.ts).
//
// Coverage policy: events with a player actor (signal). Pure-environmental events
// (BlockBurn/Fade/Spread/Form/Grow/FromTo/LeavesDecay/Piston) are SKIPPED on purpose
// — the model would have to filter them out of every batch.
//
// All handlers run at MONITOR priority, ignoring cancelled events, so we observe the
// final outcome rather than racing other plugins' decisions.
public final class BlockListener implements Listener {
  private final Logger log;

  public BlockListener(Logger log) {
    this.log = log;
  }

  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onBreak(BlockBreakEvent e) {
    Block b = e.getBlock();
    log.info("block_break " + e.getPlayer().getName() + " " + xyz(b.getLocation()) + " "
        + lower(b.getType().name()) + " " + worldName(b.getLocation()));
  }

  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onPlace(BlockPlaceEvent e) {
    Block b = e.getBlockPlaced();
    log.info("block_place " + e.getPlayer().getName() + " " + xyz(b.getLocation()) + " "
        + lower(b.getType().name()) + " " + worldName(b.getLocation()));
  }

  // Block-source explosion (respawn anchor in overworld, bed in nether, end crystal).
  // No player actor on the event itself, but the placement/arming that triggered it
  // appears earlier in the log as a block_place line — attribution is reconstructible.
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onBlockExplode(BlockExplodeEvent e) {
    Location loc = e.getBlock().getLocation();
    log.info("block_explode block:" + lower(e.getBlock().getType().name()) + " "
        + xyz(loc) + " " + e.blockList().size() + "blocks " + worldName(loc));
  }

  // Entity-source explosion (TNT, creeper, end crystal, ghast fireball, ...).
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onEntityExplode(EntityExplodeEvent e) {
    Location loc = e.getLocation();
    log.info("block_explode entity:" + lower(e.getEntity().getType().name()) + " "
        + xyz(loc) + " " + e.blockList().size() + "blocks " + worldName(loc));
  }

  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onBucketFill(PlayerBucketFillEvent e) {
    Block b = e.getBlockClicked();
    log.info("block_bucket_fill " + e.getPlayer().getName() + " " + xyz(b.getLocation()) + " "
        + lower(e.getBucket().name()) + " " + worldName(b.getLocation()));
  }

  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onBucketEmpty(PlayerBucketEmptyEvent e) {
    Block b = e.getBlockClicked();
    log.info("block_bucket_empty " + e.getPlayer().getName() + " " + xyz(b.getLocation()) + " "
        + lower(e.getBucket().name()) + " " + worldName(b.getLocation()));
  }

  // getLines() is deprecated in favor of Adventure Components, but for our log line
  // we just want plain text — String[] is more direct than serializing Components.
  @SuppressWarnings("deprecation")
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onSign(SignChangeEvent e) {
    Block b = e.getBlock();
    String text = String.join(" | ", sanitize(e.getLines()));
    log.info("block_sign " + e.getPlayer().getName() + " " + xyz(b.getLocation()) + " "
        + worldName(b.getLocation()) + " text=" + text);
  }

  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onHangingPlace(HangingPlaceEvent e) {
    Player p = e.getPlayer();
    if (p == null) return; // placed by dispenser/explosion — no actor
    Hanging h = e.getEntity();
    log.info("block_hanging_place " + p.getName() + " " + xyz(h.getLocation()) + " "
        + lower(h.getType().name()) + " " + worldName(h.getLocation()));
  }

  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onHangingBreak(HangingBreakByEntityEvent e) {
    Entity remover = e.getRemover();
    Hanging h = e.getEntity();
    String breaker;
    if (remover instanceof Player p) breaker = p.getName();
    else if (remover != null) breaker = "entity:" + lower(remover.getType().name());
    else breaker = "unknown";
    log.info("block_hanging_break " + breaker + " " + xyz(h.getLocation()) + " "
        + lower(h.getType().name()) + " " + worldName(h.getLocation()));
  }

  // Only ignites with a player actor — lava/lightning ignition is environmental noise.
  // cause is preserved so flint_and_steel vs fireball stays legible.
  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onIgnite(BlockIgniteEvent e) {
    Player p = e.getPlayer();
    if (p == null) return;
    Block b = e.getBlock();
    log.info("block_ignite " + p.getName() + " " + xyz(b.getLocation()) + " "
        + lower(e.getCause().name()) + " " + worldName(b.getLocation()));
  }

  private static String xyz(Location loc) {
    return loc.getBlockX() + " " + loc.getBlockY() + " " + loc.getBlockZ();
  }

  private static String worldName(Location loc) {
    return loc.getWorld() != null ? loc.getWorld().getName() : "unknown";
  }

  private static String lower(String enumName) {
    return enumName.toLowerCase();
  }

  // Sign lines may contain newlines or our '|' separator — strip both so a single log
  // line stays unambiguous. We keep spaces (sign text is naturally spaced).
  private static String[] sanitize(String[] lines) {
    String[] out = new String[lines.length];
    for (int i = 0; i < lines.length; i++) {
      String s = lines[i] == null ? "" : lines[i];
      out[i] = s.replace("\n", " ").replace("\r", " ").replace("|", "/");
    }
    return out;
  }
}
