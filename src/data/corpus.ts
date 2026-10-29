// Training text for the tokenizer and the tiny language model. Written for this
// site (not scraped), so it can ship under the same licence as everything else.

export const CORPUS = `the panda sat at the edge of the bamboo forest and opened a laptop. the laptop was old, but the panda was curious, and curious pandas learn by breaking things.

first the panda learned the terminal. the terminal is a place where you type a command and the computer types back. the panda typed ls and saw the files. the panda typed cat and saw what was inside them. nothing broke, so the panda typed more.

then the panda learned git. git remembers every version of every file, and it gives each version a name made from its contents. if two files are the same, they get the same name. if one letter changes, the name changes completely. the panda changed one letter and watched the name change, and laughed.

a branch is just a name for a commit. the panda made a branch called snack and wrote a new line on it. back on main, the panda wrote a different line in the same place. when the panda merged the two, git stopped and asked which line was right. that is a conflict. a conflict is not an error. it is git being honest that it cannot read your mind.

next the panda learned containers. a container is a process that thinks it is alone. it has its own files, its own network and its own limits, but it shares the kernel with everything else on the machine. an image is the recipe and the files. a container is the image running.

kubernetes is a machine for keeping promises. you tell it what you want, and it keeps checking whether the world matches. if a pod dies, it makes a new one. if a node is full, the pod waits. the panda deleted a pod on purpose and watched a new one appear with a different name. the panda felt powerful, then deleted another one.

when a pod would not start, the panda learned to read the events. the events said there was not enough cpu. the panda asked for less cpu and the pod started. when a pod kept restarting, the panda looked at the exit code. the exit code was one hundred and thirty seven, which only means that something killed it. the reason said what. the events said why.

then the panda learned about learning. a model is a function with knobs. training is turning the knobs a little at a time so the answers get less wrong. the loss is how wrong the answers are. the gradient says which way to turn each knob. a network with no hidden layer can only draw a straight line. a network with a hidden layer can draw curves, and with enough curves it can draw almost anything.

a language model reads text as tokens. a token is a piece of a word, or a whole word, or a space and a word. the model looks at the tokens so far and gives a probability to every token that could come next. then it picks one, adds it to the text, and does it all again. the temperature says how adventurous the picking is. at zero it always picks the most likely token. turned up high, it picks strange tokens and says strange things.

serving a model to many people at once is mostly a memory problem. every token the model has read is kept in a cache of keys and values so it does not have to read it again. the cache grows with every token. if you reserve room for the longest possible answer, most of that room sits empty. if you hand out memory in small pages only when it is needed, many more people fit at once. the panda drew the pages as little squares and watched them fill.

at the end of the day the panda closed the laptop and looked at the forest. there was so much left to learn. the panda smiled, because that was the best part.
`;
