import ChatRouteContent from "@/components/chat/ChatRouteContent";

export { guardChatRoute as loader } from "@/lib/chat-availability.server";
export { meta } from "./home";

export default function ChatThreadRoute() {
  return <ChatRouteContent />;
}
