import SwiftUI
import ConversationsKit

/// Minimal demo: enter the address of your Conversations deployment and a hosted-chat token, then chat.
/// Both can also be given as launch arguments: `-ConversationsURL https://... -ConversationsToken cvt_...` (Xcode scheme > Arguments).
@main
struct DemoApp: App {
    var body: some Scene { WindowGroup { RootView() } }
}

struct RootView: View {
    @State private var urlText = UserDefaults.standard.string(forKey: "ConversationsURL") ?? "http://localhost:3000"
    @State private var token = UserDefaults.standard.string(forKey: "ConversationsToken") ?? ""
    @State private var started = false
    @State private var unread = 0
    @State private var lastEvent = ""

    var body: some View {
        if started, let url = URL(string: urlText) {
            NavigationView {
                ConversationsChatView(
                    configuration: ConversationsConfiguration(baseURL: url, token: token, deviceId: UserDefaults.standard.string(forKey: "ConversationsDeviceId"), debug: true),
                    shouldOpen: { url, _ in UIApplication.shared.open(url); return true }
                ) { event in
                    switch event {
                    case .ready(let info): UserDefaults.standard.set(info.deviceId, forKey: "ConversationsDeviceId"); lastEvent = "ready"
                    case .unreadCountChanged(let n): unread = n
                    case .messageReceived(let m): lastEvent = "message: \(m.preview)"
                    case .error(let code, _, _): lastEvent = "error \(code)"
                    default: break
                    }
                }
                .navigationBarTitle("Support (\(unread) unread)", displayMode: .inline)
                .navigationBarItems(leading: Button("Settings") { started = false })
            }
            .navigationViewStyle(StackNavigationViewStyle())
        } else {
            Form {
                Section(header: Text("Conversations deployment")) {
                    TextField("https://your-app.example.com", text: $urlText).autocapitalization(.none).disableAutocorrection(true).keyboardType(.URL)
                    TextField("cvt_... (hosted chat enabled)", text: $token).autocapitalization(.none).disableAutocorrection(true)
                }
                Button("Open chat") {
                    UserDefaults.standard.set(urlText, forKey: "ConversationsURL")
                    UserDefaults.standard.set(token, forKey: "ConversationsToken")
                    started = true
                }.disabled(URL(string: urlText) == nil || token.isEmpty)
                if !lastEvent.isEmpty { Text("Last event: \(lastEvent)").font(.footnote) }
            }
        }
    }
}
