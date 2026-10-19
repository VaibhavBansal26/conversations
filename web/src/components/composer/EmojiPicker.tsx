import { Icon } from "../ui/Icon";
import { Popover } from "../ui/Popover";

const EMOJI = ["😀", "😃", "😄", "😁", "😊", "🙂", "😉", "😍", "🥰", "😘", "😎", "🤗", "🤔", "😅", "😂", "🤣", "😢", "😭", "😮", "😴", "👍", "👎", "👏", "🙌", "🙏", "💪", "👋", "✅", "❌", "⭐", "🔥", "🎉", "❤️", "💡", "📎", "📞", "📧", "⏰", "🚀", "👀"];

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <Popover label="Insert emoji" trigger={<Icon name="smile" />} triggerClassName="icon-btn" panelClassName="emoji-panel">
      {(close) => (
        <div className="emoji-grid" role="group" aria-label="Emoji">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              className="emoji-btn"
              aria-label={`Insert ${e}`}
              onClick={() => {
                onPick(e);
                close();
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
