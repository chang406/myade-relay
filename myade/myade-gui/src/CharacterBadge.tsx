type CharacterBadgeProps = {
  name: string;
  color: string;
  iconDataUri?: string | null;
  className?: string;
};

// Small circular avatar for a character: a custom icon image if one is set
// (iconDataUri, from characters/<id>.md's `icon:` frontmatter), otherwise
// the character's `color` as a background with their initial letter. No
// pane-specific logic - reused as-is by the companion character picker in
// a later round.
function CharacterBadge({ name, color, iconDataUri, className }: CharacterBadgeProps) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const classes = ["character-badge", className].filter(Boolean).join(" ");

  return (
    <span className={classes} style={iconDataUri ? undefined : { backgroundColor: color }} title={name}>
      {iconDataUri ? (
        <img className="character-badge-icon" src={iconDataUri} alt={name} />
      ) : (
        <span className="character-badge-initial">{initial}</span>
      )}
    </span>
  );
}

export default CharacterBadge;
