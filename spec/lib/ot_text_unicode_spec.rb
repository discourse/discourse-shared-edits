# frozen_string_literal: true

RSpec.describe OtTextUnicode do
  it "can apply operations to text" do
    result = OtTextUnicode.apply("😎hello world", [7, { d: 9 }, "hello"])
    expect(result).to eq("😎hello hello")
  end

  it "what happens when stuff is stacked" do
    text = "I like bananas"
    op1 = [2, { d: 4 }, "eat"]
    op2 = [7, { d: 7 }, "apples"]

    op1a = OtTextUnicode.transform(op1, op2)

    result = OtTextUnicode.apply(text, op2)
    result = OtTextUnicode.apply(result, op1a)

    expect(result).to eq("I eat apples")
  end
end
