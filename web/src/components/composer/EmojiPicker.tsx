import { Smile } from "lucide-react";
import { useState } from "react";
import { Popover, SegmentedList, SegmentedTrigger, Tabs, Tooltip } from "../../ui";

const GROUPS: Record<string, string[]> = {
  Smileys: ["😀", "😃", "😄", "😁", "😊", "🙂", "😉", "😍", "🥰", "😘", "😎", "🤗", "🤔", "😅", "😂", "🤣", "😢", "😭", "😮", "😴"],
  Gestures: ["👍", "👎", "👏", "🙌", "🙏", "💪", "👋", "👌", "🤝", "✌️", "🤞", "👀"],
  Objects: ["✅", "❌", "⭐", "🔥", "🎉", "❤️", "💡", "📎", "📞", "📧", "⏰", "🚀", "📦", "💳", "🔒", "📅"],
};

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [group, setGroup] = useState("Smileys");
  return (
    <Popover
      label="Insert emoji"
      trigger={
        <Tooltip content="Emoji">
          <span className="grid size-8 place-items-center">
            <Smile className="size-4" aria-hidden="true" />
          </span>
        </Tooltip>
      }
      triggerClassName="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
      panelClassName="w-72 p-2"
    >
      {(close) => (
        <div>
          <Tabs value={group} onValueChange={setGroup}>
            <SegmentedList aria-label="Emoji group" className="mb-2 w-full">
              {Object.keys(GROUPS).map((g) => (
                <SegmentedTrigger key={g} value={g} className="flex-1 justify-center text-xs">
                  {g}
                </SegmentedTrigger>
              ))}
            </SegmentedList>
          </Tabs>
          <div className="grid grid-cols-8 gap-0.5" role="group" aria-label="Emoji">
            {GROUPS[group]!.map((e) => (
              <button
                key={e}
                type="button"
                aria-label={`Insert ${e}`}
                onClick={() => {
                  onPick(e);
                  close();
                }}
                className="grid size-8 place-items-center rounded-md text-lg hover:bg-surface-2"
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}
